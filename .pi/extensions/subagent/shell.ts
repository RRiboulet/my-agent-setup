// Shell quoting, shared by the extension and its panel builders.
//
// This lives in its own module rather than in `index.ts` because `panel.ts`
// builds tmux command strings too: importing the quoter from `index.ts` while
// `index.ts` imports the builders from `panel.ts` would create a cycle. The
// function is deliberately tiny; `pure.test.ts` pins its exact output.

/**
 * Quote a value for a POSIX shell, as a single-quoted word.
 *
 * Every value is quoted, empty or not, so a caller never has to reason about
 * which inputs are safe bare. Single quotes inside the value are closed, an
 * escaped quote is appended, and the string is reopened, which is the only
 * sequence a single-quoted shell word cannot represent literally.
 */
export function shellQuote(value: string): string {
	if (value.length === 0) return "''";
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}
