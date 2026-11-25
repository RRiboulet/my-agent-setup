# When to mock

Mock at **system boundaries** only:

- External APIs (payments, email, third-party services).
- Time and randomness.
- Databases and the filesystem, sometimes. Prefer a real test database or a temporary directory when they are cheap.

Do not mock:

- Your own modules or classes.
- Internal collaborators.
- Anything you control and can run for real cheaply.

## Design boundaries so they are easy to fake

**Inject dependencies** rather than constructing them inside:

```typescript
// Easy to fake
function processPayment(order, paymentClient) {
  return paymentClient.charge(order.total);
}

// Hard to fake
function processPayment(order) {
  const client = new StripeClient(process.env.STRIPE_KEY);
  return client.charge(order.total);
}
```

**Prefer specific operations over one generic fetcher**, so each fake returns one shape and needs no conditional logic:

```typescript
// GOOD
const api = {
  getUser: (id) => fetch(`/users/${id}`),
  createOrder: (data) => fetch("/orders", { method: "POST", body: data }),
};

// BAD: the fake has to branch on the endpoint
const api = { fetch: (endpoint, options) => fetch(endpoint, options) };
```

## Control nondeterminism

Pin time with an injected clock, seed random generators, isolate the filesystem in a temporary directory, and block real network access in unit tests. Use the project's existing fixtures for this where they exist.
