import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as assert from "node:assert";
import { assert as vassert } from "vitest";
// ----------------------------
// Primitives
// ----------------------------
/**
 * Fails the current test with the provided error message.
 *
 * @stability unstable
 * @category testing
 * @since 4.0.0
 */
export function fail(message) {
  assert.fail(message);
}
/**
 * Asserts that `actual` is deeply strictly equal to `expected` using Node's `assert.deepStrictEqual`.
 *
 * @stability unstable
 * @category testing
 * @since 4.0.0
 */
export function deepStrictEqual(actual, expected, message, ..._) {
  if (message !== undefined) {
    assert.deepStrictEqual(actual, expected, message);
  } else {
    assert.deepStrictEqual(actual, expected);
  }
}
/**
 * Asserts that `actual` is not deeply strictly equal to `expected` using Node's `assert.notDeepStrictEqual`.
 *
 * @stability unstable
 * @category testing
 * @since 4.0.0
 */
export function notDeepStrictEqual(actual, expected, message, ..._) {
  if (message !== undefined) {
    assert.notDeepStrictEqual(actual, expected, message);
  } else {
    assert.notDeepStrictEqual(actual, expected);
  }
}
/**
 * Asserts that `actual` is strictly equal to `expected` using Node's `assert.strictEqual`.
 *
 * @stability unstable
 * @category testing
 * @since 4.0.0
 */
export function strictEqual(actual, expected, message, ..._) {
  if (message !== undefined) {
    assert.strictEqual(actual, expected, message);
  } else {
    assert.strictEqual(actual, expected);
  }
}
/**
 * Asserts that `actual` is equal to `expected` using the `Equal.equals` trait.
 *
 * @stability unstable
 * @category testing
 * @since 4.0.0
 */
export function assertEquals(actual, expected, message, ..._) {
  if (!Equal.equals(actual, expected)) {
    deepStrictEqual(actual, expected, message); // show diff
    fail(message ?? "Expected values to be Equal.equals");
  }
}
/**
 * Asserts that `thunk` does not throw an error.
 *
 * @stability unstable
 * @category testing
 * @since 4.0.0
 */
export function doesNotThrow(thunk, message, ..._) {
  assert.doesNotThrow(thunk, message);
}
// ----------------------------
// Derived
// ----------------------------
/**
 * Asserts that `value` is an instance of `constructor`.
 *
 * @stability unstable
 * @category testing
 * @since 4.0.0
 */
export function assertInstanceOf(value, constructor, message, ..._) {
  vassert.instanceOf(value, constructor, message);
}
/**
 * Asserts that `self` is `true`.
 *
 * @stability unstable
 * @category testing
 * @since 4.0.0
 */
export function assertTrue(self, message, ..._) {
  strictEqual(self, true, message);
}
/**
 * Asserts that `self` is `false`.
 *
 * @stability unstable
 * @category testing
 * @since 4.0.0
 */
export function assertFalse(self, message, ..._) {
  strictEqual(self, false, message);
}
/**
 * Asserts that `actual` includes `expected`.
 *
 * @stability unstable
 * @category testing
 * @since 4.0.0
 */
export function assertInclude(actual, expected, ..._) {
  if (typeof expected === "string") {
    if (!actual?.includes(expected)) {
      fail(`Expected\n\n${actual}\n\nto include\n\n${expected}`);
    }
  }
}
/**
 * Asserts that `actual` matches `regExp`.
 *
 * @stability unstable
 * @category testing
 * @since 4.0.0
 */
export function assertMatch(actual, regExp, ..._) {
  if (!regExp.test(actual)) {
    fail(`Expected\n\n${actual}\n\nto match\n\n${regExp}`);
  }
}
/**
 * Asserts that `thunk` throws, optionally checking the thrown value against an expected `Error` or validation function.
 *
 * @stability unstable
 * @category testing
 * @since 4.0.0
 */
export function throws(thunk, error, ..._) {
  try {
    thunk();
  } catch (e) {
    if (error !== undefined) {
      if (Predicate.isFunction(error)) {
        error(e);
      } else if (error) {
        deepStrictEqual(e, error);
      } else {
        throw e;
      }
    }
    return;
  }
  fail("Expected to throw an error");
}
/**
 * Asserts that `thunk` throws or returns a rejected promise, optionally checking the failure value against an expected `Error` or validation function.
 *
 * @stability unstable
 * @category testing
 * @since 4.0.0
 */
export async function throwsAsync(thunk, error, ..._) {
  try {
    await thunk();
  } catch (e) {
    if (error !== undefined) {
      if (Predicate.isFunction(error)) {
        error(e);
      } else {
        deepStrictEqual(e, error);
      }
    }
    return;
  }
  fail("Expected to throw an error");
}
// ----------------------------
// Option
// ----------------------------
/**
 * Asserts that `option` is `None`.
 *
 * @stability unstable
 * @category testing
 * @since 4.0.0
 */
export function assertNone(option, ..._) {
  deepStrictEqual(option, Option.none());
}
/**
 * Asserts that `a` is not `undefined`.
 *
 * @stability unstable
 * @category testing
 * @since 4.0.0
 */
export function assertDefined(a, ..._) {
  if (a === undefined) {
    fail("Expected value to be defined");
  }
}
/**
 * Asserts that `a` is `undefined`.
 *
 * @stability unstable
 * @category testing
 * @since 4.0.0
 */
export function assertUndefined(a, ..._) {
  if (a !== undefined) {
    fail("Expected value to be undefined");
  }
}
/**
 * Asserts that `option` is `Some` and contains a value equal to `expected`.
 *
 * @stability unstable
 * @category testing
 * @since 4.0.0
 */
export function assertSome(option, expected, ..._) {
  deepStrictEqual(option, Option.some(expected));
}
// ----------------------------
// Result
// ----------------------------
/**
 * Asserts that `result` is `Success` and contains a value equal to `expected`.
 *
 * @stability unstable
 * @category testing
 * @since 4.0.0
 */
export function assertSuccess(result, expected, ..._) {
  deepStrictEqual(result, Result.succeed(expected));
}
/**
 * Asserts that `result` is `Failure` and contains an error equal to `expected`.
 *
 * @stability unstable
 * @category testing
 * @since 4.0.0
 */
export function assertFailure(result, expected, ..._) {
  deepStrictEqual(result, Result.fail(expected));
}
// ----------------------------
// Exit
// ----------------------------
/**
 * Asserts that `exit` is a failure with a cause equal to `expected`.
 *
 * @stability unstable
 * @category testing
 * @since 4.0.0
 */
export function assertExitFailure(exit, expected, ..._) {
  deepStrictEqual(exit, Exit.failCause(expected));
}
/**
 * Asserts that `exit` is a success with a value equal to `expected`.
 *
 * @stability unstable
 * @category testing
 * @since 4.0.0
 */
export function assertExitSuccess(exit, expected, ..._) {
  deepStrictEqual(exit, Exit.succeed(expected));
}
//# sourceMappingURL=utils.js.map