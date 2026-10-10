// Unit tests for pocket's Host-header check.
//
// The check exists so a daemon bound to loopback cannot be driven through a
// DNS-rebinding attack: the browser is pointed at the attacker's domain, that
// name resolves to 127.0.0.1, and the request arrives carrying the attacker's
// Host header while the browser believes it is same-origin.
//
// The bug pinned here: a wildcard bind ("0.0.0.0") names no Host a phone can
// send, so comparing the header against the literal wildcard answered 421 to
// every request the phone actually made. Both network paths the tutorial
// recommends — same Wi-Fi and Tailscale through a container/port-forward — need
// the wildcard bind, and both were dead until the wildcard stopped being
// compared as if it were a dialable address.

import assert from "node:assert/strict";
import { test } from "node:test";

import { hostAllowed } from "../../pocket/daemon.ts";

const wildcard = { host: "0.0.0.0" };
const loopback = { host: "127.0.0.1" };
const tailscale = { host: "100.106.10.25" };

test("a wildcard bind answers the concrete Host a phone dials", () => {
	for (const host of ["100.106.10.25:8787", "192.168.1.50:8787", "172.23.0.2:8787", "localhost:8787"]) {
		assert.equal(hostAllowed(host, wildcard), true, `wildcard bind rejected ${host}`);
	}
	// Deliberate, and the one place the wildcard is looser than a concrete bind:
	// the bind already answers on every interface, and a token is mandatory, so
	// refusing this name would buy nothing an attacker could not get by dialling
	// the IP directly. Loopback binds, where rebinding actually matters, stay
	// strict (the test below).
	assert.equal(hostAllowed("evil.example:8787", wildcard), true);
});

test("an IPv6 wildcard bind answers the concrete Host too", () => {
	assert.equal(hostAllowed("[::1]:8787", { host: "::" }), true);
	assert.equal(hostAllowed("100.106.10.25:8787", { host: "::" }), true);
});

test("a loopback bind still answers only loopback spellings", () => {
	assert.equal(hostAllowed("127.0.0.1:8787", loopback), true);
	assert.equal(hostAllowed("localhost:8787", loopback), true);
	assert.equal(hostAllowed("100.106.10.25:8787", loopback), false);
	assert.equal(hostAllowed("192.168.1.50:8787", loopback), false);
});

test("a bracketed IPv6 Host keeps its address, port or not", () => {
	assert.equal(hostAllowed("[::1]:8787", { host: "::1" }), true);
	assert.equal(hostAllowed("[::1]", { host: "::1" }), true);
	assert.equal(hostAllowed("[fd7a::1]:8787", { host: "::1" }), false);
});

test("a concrete bound address answers that address and loopback only", () => {
	assert.equal(hostAllowed("100.106.10.25:8787", tailscale), true);
	assert.equal(hostAllowed("localhost:8787", tailscale), true);
	assert.equal(hostAllowed("100.106.10.26:8787", tailscale), false);
	assert.equal(hostAllowed("evil.example:8787", tailscale), false);
});

test("a missing Host is a non-browser request; an empty one is refused", () => {
	// HTTP/1.0, or a local tool: no browser, so no rebinding to defend against.
	assert.equal(hostAllowed(undefined, wildcard), true);
	assert.equal(hostAllowed(":8787", wildcard), false);
});
