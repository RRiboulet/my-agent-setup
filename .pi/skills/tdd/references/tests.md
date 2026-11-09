# Good and bad tests

Examples use TypeScript; the rules are language-agnostic.

## Good: behavior through the public interface

```typescript
test("user can check out a valid cart", async () => {
  const cart = createCart();
  cart.add(product);
  const result = await checkout(cart, paymentMethod);
  expect(result.status).toBe("confirmed");
});
```

- Tests what callers or users care about.
- Uses the public API only and survives internal refactors.
- The name describes *what*, not *how*.
- One logical assertion per test.

## Bad: coupled to the implementation

```typescript
// Breaks on refactor, catches no bug.
test("checkout calls paymentService.process", async () => {
  const mockPayment = jest.mock(paymentService);
  await checkout(cart, payment);
  expect(mockPayment.process).toHaveBeenCalledWith(cart.total);
});
```

Red flags: mocking internal collaborators, testing private functions, asserting call counts or order, a name that describes *how*.

## Bad: verifying through a side channel

```typescript
// BAD: bypasses the interface.
test("createUser saves to database", async () => {
  await createUser({ name: "Alice" });
  const row = await db.query("SELECT * FROM users WHERE name = ?", ["Alice"]);
  expect(row).toBeDefined();
});

// GOOD: reads back through the interface.
test("created user can be retrieved", async () => {
  const user = await createUser({ name: "Alice" });
  expect((await getUser(user.id)).name).toBe("Alice");
});
```

## Bad: tautological

```typescript
// BAD: expected value recomputed the way the code computes it.
test("calculateTotal sums line items", () => {
  const items = [{ price: 10 }, { price: 5 }];
  const expected = items.reduce((sum, i) => sum + i.price, 0);
  expect(calculateTotal(items)).toBe(expected);
});

// GOOD: independent, known literal.
test("calculateTotal sums line items", () => {
  expect(calculateTotal([{ price: 10 }, { price: 5 }])).toBe(15);
});
```

## When "no call happened" is the behavior

If the contract is "an empty cart never charges", asserting that the payment client received no call *is* behavior. Pair it with a case where the charge happens, so the test proves it can see a call at all.
