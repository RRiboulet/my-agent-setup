/* pocket phone client — mobile first, no build step, no dependencies.
 *
 * The client is a view of state the daemon already holds, so it follows one
 * rule: a reconnect must never lose what happened while the phone was away.
 * Everything it draws comes from three calls — the status snapshot, the message
 * history, and the journal replay — and the stream only ever adds to it. If the
 * stream dies the client backs off and re-subscribes from the last sequence it
 * saw: that is either patched forward, or answered with a `reset` telling it that
 * the buffer has aged out and the transcript has to be reloaded.
 *
 * The stream is read with fetch rather than EventSource on purpose. EventSource
 * cannot carry an Authorization header, and the alternative — a token in a query
 * string — writes a credential into every log and history list between the phone
 * and the daemon.
 */

const state = {
	view: "list",
	sessionId: null,
	sessions: [],
	entry: null,
	status: null,
	cursor: 0,
	seq: 0,
	clientId: null,
	messages: [],
	tools: new Map(),
	dialogs: new Map(),
	/** Assistant text streaming in, before its message_end finalises it. */
	stream: null,
	streamController: null,
	retryTimer: null,
	retryDelay: 1000,
	token: null,
	operator: null,
	host: location.origin,
};

const byId = (id) => document.getElementById(id);

/* --- settings ------------------------------------------------------------ */

function loadSettings() {
	state.clientId = localStorage.getItem("pocket.clientId") || null;
	if (state.clientId === null) {
		state.clientId = `${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
		localStorage.setItem("pocket.clientId", state.clientId);
	}
	state.token = localStorage.getItem("pocket.token") || null;
	state.operator = localStorage.getItem("pocket.operator") || null;
	state.host = localStorage.getItem("pocket.host") || location.origin;
}

/* --- api ---------------------------------------------------------------- */

async function api(path, options = {}) {
	const headers = { ...(options.headers || {}) };
	if (state.token !== null) headers.Authorization = `Bearer ${state.token}`;
	if (options.body !== undefined) headers["Content-Type"] = "application/json";
	let response;
	try {
		response = await fetch(`${state.host}${path}`, {
			method: options.method || "GET",
			headers,
			body: options.body === undefined ? undefined : JSON.stringify(options.body),
			redirect: "manual", // a redirect to a login page is not a JSON error
		});
	} catch (error) {
		throw new Error(error.message);
	}
	const text = await response.text();
	const payload = text === "" ? null : JSON.parse(text);
	if (!response.ok) {
		const message = typeof payload?.error === "string" ? payload.error : `${response.status}`;
		throw new Error(response.status === 401 ? "not paired — reconnect from the menu" : message);
	}
	return payload;
}

/* --- views -------------------------------------------------------------- */

const VIEWS = ["list", "thread", "setup"];

function show(view) {
	state.view = view;
	for (const name of VIEWS) byId(name).hidden = name !== view;
	byId("back").hidden = view !== "thread";
	byId("title").textContent = view === "thread" && state.entry !== null ? state.entry.name : "pocket";
}

function renderStatus() {
	const status = state.status;
	if (status === null) return;
	const label = status.live ? (status.busy ? "working" : "idle") : status.lastError !== undefined && status.lastError !== null ? "stopped" : "stopped";
	const pill = byId("state");
	pill.textContent = status.lastError !== undefined && status.lastError !== null && !status.live ? `${label}: ${status.lastError}` : label;
	pill.className = `pill ${status.busy ? "busy" : status.live ? "live" : "dead"}`;
	byId("model").textContent = state.entry?.model ? `${state.entry.model.provider}/${state.entry.model.id}` : "";
	byId("toggle").textContent = status.live ? "Pause" : "Resume";
}

function renderSessions() {
	const list = byId("sessions");
	list.textContent = "";
	for (const session of state.sessions) {
		const status = session.status || {};
		const item = document.createElement("li");
		item.className = "session";

		const dot = document.createElement("span");
		dot.className = `dot ${status.busy ? "busy" : status.live ? "live" : "dead"}`;

		const body = document.createElement("div");
		body.className = "session-body";
		const name = document.createElement("strong");
		name.textContent = session.name || session.id;
		const meta = document.createElement("span");
		meta.className = "hint";
		meta.textContent = status.live ? (status.busy ? "working" : "idle") : status.lastError ? `stopped: ${status.lastError}` : "stopped";
		const cwd = document.createElement("span");
		cwd.className = "cwd";
		cwd.textContent = session.cwd;
		body.append(name, meta, cwd);

		item.append(dot, body);
		item.onclick = () => void openSession(session.id);
		list.append(item);
	}
	byId("status").textContent =
		state.sessions.length === 0
			? "No sessions yet. Create one: the conversation outlives the phone."
			: "";
}

/** The content of a pi message, as ordered display parts. */
function partsOf(message) {
	const content = message.content;
	if (typeof content === "string") return [{ kind: "text", text: content }];
	if (!Array.isArray(content)) return [{ kind: "text", text: jsonPreview(content) }];
	const parts = [];
	for (const raw of content) {
		if (typeof raw === "string") {
			parts.push({ kind: "text", text: raw });
			continue;
		}
		if (raw === null || typeof raw !== "object") continue;
		const type = raw.type || "text";
		if (type === "text") parts.push({ kind: "text", text: raw.text || "" });
		else if (type === "thinking") parts.push({ kind: "thinking", text: raw.thinking || raw.text || "…" });
		else if (type === "toolCall") {
			const call = raw.toolCall || raw;
			parts.push({ kind: "tool", name: call.toolName || call.name || "tool", args: call.args ?? call.arguments });
		}
	}
	return parts.length === 0 ? [{ kind: "text", text: "(no content)" }] : parts;
}

function jsonPreview(value) {
	try {
		const text = typeof value === "string" ? value : JSON.stringify(value);
		return text.length > 200 ? `${text.slice(0, 200)}…` : text;
	} catch {
		return "";
	}
}

function appendMessage(role, parts) {
	const list = byId("messages");
	for (const part of parts) {
		if (part.kind === "tool") {
			list.append(bubble(role, `tool: ${part.name} ${jsonPreview(part.args)}`));
			continue;
		}
		list.append(bubble(role, part.text));
	}
	scrollToEnd();
}

function bubble(role, text) {
	const item = document.createElement("li");
	item.className = `msg ${role}`;
	if (role === "note" || role === "tool") {
		const note = document.createElement("span");
		note.textContent = text;
		item.append(note);
		return item;
	}
	const pre = document.createElement("pre");
	pre.textContent = text;
	item.append(pre);
	return item;
}

function renderMessages() {
	const list = byId("messages");
	list.textContent = "";
	state.tools.clear();
	for (const message of state.messages) {
		appendMessage(message.role === "user" ? "user" : "assistant", partsOf(message));
	}
	scrollToEnd();
}

function scrollToEnd() {
	const list = byId("messages");
	list.scrollTop = list.scrollHeight;
}

/* --- journal records ---------------------------------------------------- */

function handleRecord(record) {
	if (record.kind === "pi_event") return handlePiEvent(record.event);
	if (record.kind === "extension_ui") return handleDialog(record.request);
	if (record.kind === "gateway_event") return handleGatewayEvent(record);
}

function handlePiEvent(event) {
	switch (event.type) {
		case "message_start":
			if (event.message?.role === "assistant") state.stream = "";
			return;
		case "message_update": {
			const inner = event.assistantMessageEvent;
			if (inner !== null && inner !== undefined && inner.type === "text_delta" && typeof inner.delta === "string") {
				if (state.stream === null) state.stream = "";
				state.stream += inner.delta;
				drawStream();
			}
			return;
		}
		case "message_end": {
			state.stream = null;
			const message = event.message || {};
			if (message.role === "assistant" || message.role === "user") {
				state.messages.push(message);
				appendMessage(message.role, partsOf(message));
			}
			return;
		}
		case "tool_execution_start":
			state.tools.set(event.toolCallId, { name: event.toolName, args: event.args });
			appendMessage("tool", [{ kind: "tool", name: event.toolName, args: event.args }]);
			return;
		case "tool_execution_end": {
			const tool = state.tools.get(event.toolCallId);
			byId("messages").append(bubble("tool", `${tool?.name || "tool"} ${jsonPreview(event.result)}${event.isError ? " (error)" : ""}`));
			scrollToEnd();
			return;
		}
		case "agent_settled":
			state.stream = null;
			renderStatus();
			return;
		case "agent_start":
			renderStatus();
			return;
		default:
			return;
	}
}

function drawStream() {
	let node = byId("messages").querySelector(".stream");
	if (node === null) {
		node = document.createElement("li");
		node.className = "msg assistant stream";
		node.append(document.createElement("pre"));
		byId("messages").append(node);
	}
	node.firstChild.textContent = state.stream || "";
	scrollToEnd();
}

function handleGatewayEvent(record) {
	if (record.event === "child_exited") appendMessage("note", [{ kind: "text", text: "the agent process exited — restarting it" }]);
	if (record.event === "child_respawn") appendMessage("note", [{ kind: "text", text: `conversation resumed (attempt ${record.attempt})` }]);
	if (record.event === "session_started") appendMessage("note", [{ kind: "text", text: "session started" }]);
	if (record.event === "session_resumed") appendMessage("note", [{ kind: "text", text: "conversation resumed from its transcript" }]);
	if (record.event === "dialog_answered") state.dialogs.delete(record.requestId);
}

function handleDialog(request) {
	if (request === null || request === undefined || typeof request.id !== "string") return;
	state.dialogs.set(request.id, request);
	renderDialogs();
}

function renderDialogs() {
	const host = byId("dialogs");
	host.textContent = "";
	for (const [id, request] of state.dialogs) {
		const box = document.createElement("div");
		box.className = "dialog";

		const title = document.createElement("strong");
		title.textContent = request.title || request.method;
		const message = document.createElement("p");
		message.textContent = request.message || "";
		box.append(title, message);

		if (request.method === "confirm") {
			box.append(answerButton(id, "Yes", { confirmed: true }), answerButton(id, "No", { confirmed: false }));
		} else if (request.method === "select") {
			for (const option of request.options || []) box.append(answerButton(id, option, { value: option }));
			box.append(answerButton(id, "Cancel", { cancelled: true }));
		} else {
			const field = document.createElement("input");
			field.placeholder = request.placeholder || "Type a reply";
			field.value = request.prefill || "";
			const send = document.createElement("button");
			send.textContent = "Reply";
			send.onclick = () => void sendAnswer(id, { value: field.value });
			box.append(field, send);
		}
		host.append(box);
	}
}

function answerButton(id, label, body) {
	const button = document.createElement("button");
	button.textContent = label;
	button.onclick = () => void sendAnswer(id, body);
	return button;
}

async function sendAnswer(id, body) {
	try {
		await api(`/api/sessions/${state.sessionId}/answer/${encodeURIComponent(id)}`, { method: "POST", body });
		state.dialogs.delete(id);
		renderDialogs();
	} catch (error) {
		appendMessage("note", [{ kind: "text", text: `could not answer: ${error.message}` }]);
	}
}

/* --- streaming ---------------------------------------------------------- */

/**
 * Read one SSE response with fetch, so the Authorization header goes with it.
 *
 * `event:`/`data:` pairs are reassembled by hand: the daemon writes records one
 * per frame and the only framing the protocol needs is an empty line.
 */
function subscribe(cursor) {
	stopStream();
	const controller = new AbortController();
	state.streamController = controller;
	const url = `${state.host}/api/sessions/${state.sessionId}/events?cursor=${cursor}`;
	const headers = {};
	if (state.token !== null) headers.Authorization = `Bearer ${state.token}`;

	fetch(url, { headers, signal: controller.signal })
		.then(async (response) => {
			if (!response.ok) throw new Error(`stream refused (${response.status})`);
			if (response.body === null) throw new Error("no stream body");
			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			for (;;) {
				const { done, value } = await reader.read();
				if (done) throw new Error("stream closed");
				buffer += decoder.decode(value, { stream: true });
				let split = buffer.indexOf("\n\n");
				while (split >= 0) {
					const frame = buffer.slice(0, split);
					buffer = buffer.slice(split + 2);
					onFrame(frame);
					split = buffer.indexOf("\n\n");
				}
			}
		})
		.catch((error) => {
			if (controller.signal.aborted) return;
			if (state.view === "thread") scheduleReconnect(error);
		});
}

function onFrame(frame) {
	let event = "record";
	let data = "";
	for (const line of frame.split("\n")) {
		if (line.startsWith(":")) continue;
		if (line.startsWith("event:")) event = line.slice(6).trim();
		if (line.startsWith("data:")) data += line.slice(5).trim();
	}
	if (data === "") return;
	let payload;
	try {
		payload = JSON.parse(data);
	} catch {
		return;
	}
	if (event === "reset") {
		state.cursor = typeof payload.cursor === "number" ? payload.cursor : 0;
		void reloadHistory();
		return;
	}
	if (typeof payload.seq === "number") state.cursor = payload.seq;
	handleRecord(payload);
}

function stopStream() {
	if (state.streamController !== null) {
		state.streamController.abort();
		state.streamController = null;
	}
	if (state.retryTimer !== null) {
		clearTimeout(state.retryTimer);
		state.retryTimer = null;
	}
	state.retryDelay = 1000;
}

function scheduleReconnect(error) {
	appendMessage("note", [{ kind: "text", text: `connection lost (${error.message}); reconnecting` }]);
	if (state.retryTimer !== null) clearTimeout(state.retryTimer);
	state.retryTimer = setTimeout(() => {
		state.retryTimer = null;
		if (state.view === "thread") subscribe(state.cursor);
	}, state.retryDelay);
	state.retryDelay = Math.min(state.retryDelay * 1.6, 5000);
}

/* --- session lifecycle -------------------------------------------------- */

async function loadSessions() {
	const payload = await api("/api/state");
	state.sessions = payload.sessions || [];
	// The list endpoint returns each live status too, so the one being viewed
	// stays fresh here rather than being refreshed only on a full load.
	if (state.sessionId !== null) {
		const current = state.sessions.find((entry) => entry.id === state.sessionId);
		if (current?.status) state.status = current.status;
	}
	renderSessions();
	if (state.view === "thread") renderStatus();
}

async function openSession(id) {
	state.sessionId = id;
	state.messages = [];
	state.stream = null;
	state.dialogs.clear();
	byId("messages").textContent = "";
	show("thread");
	await refresh();
}

async function refresh() {
	try {
		const payload = await api(`/api/sessions/${state.sessionId}`);
		state.entry = payload.entry;
		state.status = payload.status;
		state.cursor = payload.cursor || 0;
		for (const request of payload.status?.dialogs || []) state.dialogs.set(request.id, request);
		renderSessions();
		renderStatus();
		await reloadHistory();
		subscribe(state.cursor);
	} catch (error) {
		appendMessage("note", [{ kind: "text", text: error.message }]);
	}
}

async function reloadHistory() {
	try {
		state.messages = (await api(`/api/sessions/${state.sessionId}/messages?limit=200`)) || [];
	} catch {
		state.messages = [];
	}
	state.stream = null;
	renderMessages();
	renderDialogs();
}

async function sendPrompt() {
	const input = byId("input");
	const text = input.value.trim();
	if (text === "") return;
	input.value = "";
	autoGrow();
	state.seq += 1;
	// (clientId, seq) is the phone's dedup key: a prompt that crossed a network
	// drop must not be delivered twice when the phone retries.
	const path = `/api/sessions/${state.sessionId}/prompt?clientId=${encodeURIComponent(state.clientId)}&seq=${state.seq}`;
	try {
		await api(path, { method: "POST", body: { message: text } });
	} catch (error) {
		appendMessage("note", [{ kind: "text", text: `could not send: ${error.message}` }]);
	}
}

/* --- pairing ------------------------------------------------------------ */

async function submitPairing() {
	const code = byId("code").value.trim();
	const label = byId("label").value.trim() || "phone";
	const host = (byId("host").value.trim() || state.host).replace(/\/$/, "");
	if (code === "") throw new Error("enter the pairing code");
	let response;
	try {
		response = await fetch(`${host}/api/pair`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ code, label }),
		});
	} catch (error) {
		throw new Error(`could not reach ${host}: ${error.message}`);
	}
	const text = await response.text();
	const payload = text === "" ? {} : JSON.parse(text);
	if (!response.ok) throw new Error(typeof payload.error === "string" ? payload.error : "pairing failed");
	state.token = payload.token;
	state.host = host;
	localStorage.setItem("pocket.token", state.token);
	localStorage.setItem("pocket.host", state.host);
	await loadSessions();
	show("list");
}

async function loadDevices() {
	if (state.operator === null) return;
	let devices;
	try {
		const response = await fetch(`${state.host}/api/devices`, { headers: { Authorization: `Bearer ${state.operator}` } });
		if (!response.ok) return;
		devices = await response.json();
	} catch {
		return;
	}
	const list = byId("devices");
	list.textContent = "";
	for (const device of devices) {
		const item = document.createElement("li");
		const name = document.createElement("span");
		name.textContent = `${device.label} — ${device.id}`;
		const revoke = document.createElement("button");
		revoke.className = "ghost";
		revoke.textContent = "Revoke";
		revoke.onclick = async () => {
			await fetch(`${state.host}/api/devices/${encodeURIComponent(device.id)}`, {
				method: "DELETE",
				headers: { Authorization: `Bearer ${state.operator}` },
			});
			void loadDevices();
		};
		item.append(name, revoke);
		list.append(item);
	}
}

/* --- wiring ------------------------------------------------------------- */

function autoGrow() {
	const input = byId("input");
	input.style.height = "auto";
	input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
}

function wire() {
	byId("back").onclick = () => {
		stopStream();
		state.sessionId = null;
		state.entry = null;
		state.status = null;
		show("list");
		void loadSessions().catch(() => {});
	};
	byId("menu").onclick = () => {
		byId("code").value = "";
		byId("host").value = state.host;
		byId("token").value = state.operator || "";
		show("setup");
		void loadDevices();
	};
	byId("pair").onclick = async () => {
		byId("setup-error").textContent = "";
		try {
			await submitPairing();
		} catch (error) {
			byId("setup-error").textContent = error.message;
		}
	};
	byId("save-token").onclick = () => {
		const value = byId("token").value.trim();
		state.operator = value === "" ? null : value;
		localStorage.setItem("pocket.operator", state.operator || "");
		void loadDevices();
	};
	byId("revoke").onclick = () => {
		// Drop this phone's credential: the next action puts us back in pairing.
		localStorage.removeItem("pocket.token");
		state.token = null;
		stopStream();
		show("setup");
		byId("setup-error").textContent = "this phone's token was removed";
	};
	byId("composer").onsubmit = (event) => {
		event.preventDefault();
		void sendPrompt();
	};
	byId("input").oninput = autoGrow;
	byId("input").onkeydown = (event) => {
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			void sendPrompt();
		}
	};
	byId("abort").onclick = () => {
		api(`/api/sessions/${state.sessionId}/abort`, { method: "POST", body: {} })
			.then((payload) => {
				state.status = payload.status;
				renderStatus();
			})
			.catch((error) => appendMessage("note", [{ kind: "text", text: error.message }]));
	};
	byId("toggle").onclick = () => {
		const path = state.status?.live ? "stop" : "start";
		api(`/api/sessions/${state.sessionId}/${path}`, { method: "POST", body: {} })
			.then((payload) => {
				state.status = payload.status;
				renderStatus();
				renderSessions();
			})
			.catch((error) => appendMessage("note", [{ kind: "text", text: error.message }]));
	};
}

function registerServiceWorker() {
	// A convenience, not a dependency: the client works if registration fails,
	// and the worker is network-first for the shell so it cannot go stale.
	if ("serviceWorker" in navigator) {
		void navigator.serviceWorker.register("/service-worker.js").catch(() => {});
	}
}

let listPoll = null;

async function boot() {
	loadSettings();
	wire();
	registerServiceWorker();
	show("list");
	try {
		await loadSessions();
	} catch (error) {
		byId("status").textContent = String(error.message || error);
		show("setup");
	}
	// The list view has no stream of its own, so it polls: often enough that a
	// session that finishes is visible, slowly enough not to run a battery down.
	if (listPoll !== null) clearInterval(listPoll);
	listPoll = setInterval(() => {
		if (state.view === "list" && !document.hidden) void loadSessions().catch(() => {});
	}, 20000);
}

document.addEventListener("visibilitychange", () => {
	// A phone in the background is throttled off its stream; returning to the
	// foreground is the moment to resubscribe, not to wait out the retry timer.
	if (document.hidden) return;
	if (state.view === "thread") {
		subscribe(state.cursor);
		void refresh();
	} else if (state.view === "list") {
		void loadSessions().catch(() => {});
	}
});

void boot();
