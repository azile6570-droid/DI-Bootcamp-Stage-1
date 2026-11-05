/**
 * @since 4.0.0
 */
import * as Arbitrary from "effect/Arbitrary";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { constVoid, flow, pipe } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import * as TestConsole from "effect/testing/TestConsole";
import * as V from "vitest";
const getCurrentSuite = V.TestRunner.getCurrentSuite;
const runPromise = /*#__PURE__*/Effect.fnUntraced(function* (effect, _ctx) {
  const exit = yield* Effect.exit(effect);
  if (Exit.isFailure(exit)) {
    const errors = Cause.prettyErrors(exit.cause);
    for (let i = 0; i < errors.length; i++) {
      yield* Effect.logError(errors[i]);
    }
  }
  return yield* exit;
}, (effect, _, ctx) => Effect.runPromise(effect, {
  signal: ctx?.signal
}));
/** @internal */
const runTest = ctx => effect => {
  const promise = runPromise(effect, ctx);
  if (ctx) {
    // Vitest stops awaiting the test promise once the signal aborts (timeout or
    // cancellation), so only then add a hook that waits for the finalizers.
    // Registering it unconditionally would change the teardown of every test.
    const onAbort = () => ctx.onTestFinished(() => promise.then(constVoid, constVoid));
    ctx.signal.addEventListener("abort", onAbort, {
      once: true
    });
    const cleanup = () => ctx.signal.removeEventListener("abort", onAbort);
    promise.then(cleanup, cleanup);
    // A retry after a timed-out attempt reuses the aborted signal, so no event fires.
    if (ctx.signal.aborted) onAbort();
  }
  return promise;
};
const TestEnv = /*#__PURE__*/Layer.mergeAll(TestConsole.layer, /*#__PURE__*/TestClock.layer());
/** @internal */
export const addEqualityTesters = () => {
  V.expect.addEqualityTesters([]);
};
/** @internal */
const testOptions = timeout => typeof timeout === "number" ? {
  timeout
} : timeout ?? {};
const hookTimeout = timeout => timeout === undefined ? undefined : Duration.toMillis(Duration.fromInputUnsafe(timeout));
const propertyTestOptions = timeout => typeof timeout === "number" ? undefined : timeout;
const checkOptions = timeout => propertyTestOptions(timeout)?.arbitrary;
const compileArbitraryInput = input => Arbitrary.isArbitrary(input) ? input : Arbitrary.schema(input);
const makeArbitrary = arbitraries => Arbitrary.all(Array.isArray(arbitraries) ? arbitraries.map(compileArbitraryInput) : Object.fromEntries(Object.entries(arbitraries).map(([key, input]) => [key, compileArbitraryInput(input)])));
const normalizeProperty = (property, value) => Effect.catchCause(Effect.suspend(() => {
  const output = property(value);
  return Effect.isEffect(output) ? output : Effect.succeed(output);
}), cause => Cause.hasInterrupts(cause) ? Effect.failCause(cause) : Effect.fail(cause));
const runCheck = (ctx, arbitrary, property, options) => runTest(ctx)(Effect.flatMapEager(Arbitrary.checkEffect(arbitrary, value => normalizeProperty(property, value), options), result => {
  const failure = Arbitrary.formatCheckFailure(result);
  return failure === undefined ? Effect.void : Effect.die(new Error(failure));
}));
// Vitest decides which fixtures to set up by parsing the source of a test
// function's context parameter, and there is no public API to supply the names
// for a wrapper, so wrappers expose the source of the function they call.
const withFixturesOf = (source, f) => Object.defineProperty(f, "toString", {
  value: () => source.toString()
});
const makeItProxy = (it, overrides) => new Proxy(it, {
  apply(target, thisArg, argArray) {
    return Reflect.apply(target, thisArg, argArray);
  },
  get(target, property, receiver) {
    if (Object.hasOwn(overrides, property)) {
      return Reflect.get(overrides, property);
    }
    // do not bind: binding would strip vitest's static helpers (e.g. `describe.each`)
    return Reflect.get(target, property, receiver);
  }
});
const collectTasks = (tasks, acc = []) => {
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    if (task.type === "test" && task.mode !== "skip" && task.mode !== "todo") {
      acc.push(task);
    } else if (task.tasks !== undefined) {
      collectTasks(task.tasks, acc);
    }
  }
  return acc;
};
const registerProp = (it, name, arbitraries, property, timeout) => {
  const arbitrary = makeArbitrary(arbitraries);
  // Property callbacks receive only the base context; the empty source requests no fixtures.
  it(name, testOptions(timeout), withFixturesOf(() => {}, ctx => runCheck(ctx, arbitrary, values => property(values, ctx), checkOptions(timeout))));
};
const makeTester = (mapEffect, it) => {
  const run = (ctx, args, self) => pipe(Effect.suspend(() => self(...args)), mapEffect, runTest(ctx));
  const register = test => (name, self, timeout) => test(name, testOptions(timeout), withFixturesOf(self, ctx => run(ctx, [ctx], self)));
  const each = cases => (name, self, timeout) => it.for(cases)(name, testOptions(timeout), withFixturesOf(self, (args, ctx) => run(ctx, [args, ctx], self).then(constVoid)));
  const prop = (name, arbitraries, self, timeout) => registerProp(it, name, arbitraries, (values, ctx) => Effect.mapEager(mapEffect(Effect.suspend(() => self(values, ctx))), value => value !== false), timeout);
  return Object.assign(register(it), {
    skip: register(it.skip),
    skipIf: condition => register(it.skipIf(condition)),
    runIf: condition => register(it.runIf(condition)),
    only: register(it.only),
    each,
    fails: register(it.fails),
    prop
  });
};
const makeProp = it => (name, arbitraries, self, timeout) => registerProp(it, name, arbitraries, (values, ctx) => self(values, ctx) !== false, timeout);
const makeLayer = it => (layer_, options) => (...args) => {
  const excludeTestServices = options?.excludeTestServices ?? false;
  const withTestEnv = excludeTestServices ? layer_ : Layer.provideMerge(layer_, TestEnv);
  const memoMap = options?.memoMap ?? Effect.runSync(Layer.makeMemoMap);
  const scope = Effect.runSync(Scope.make());
  const contextEffect = Layer.buildWithMemoMap(withTestEnv, memoMap, scope).pipe(Effect.orDie, Effect.cached, Effect.runSync);
  let closed = false;
  const closeScope = () => {
    if (closed) {
      return Promise.resolve();
    }
    closed = true;
    // Layer cleanup must outlive the last test's already-aborted signal.
    return runPromise(Scope.close(scope, Exit.void));
  };
  const methods = makeItProxy(it, {
    effect: makeTester(effect => Effect.flatMap(contextEffect, context => effect.pipe(Effect.scoped, Effect.provide(context))), it),
    prop: makeProp(it),
    flakyTest,
    layer(nestedLayer, options) {
      return makeLayer(it)(Layer.provideMerge(nestedLayer, withTestEnv), {
        ...options,
        memoMap: Layer.forkMemoMapUnsafe(memoMap),
        excludeTestServices
      });
    }
  });
  if (args.length === 1) {
    const currentSuite = getCurrentSuite();
    const previousTasks = new Set(currentSuite.tasks);
    args[0](methods);
    const blockTasks = collectTasks(currentSuite.tasks.filter(task => !previousTasks.has(task)));
    if (blockTasks.length === 0) {
      V.afterAll(() => closeScope(), hookTimeout(options?.timeout));
      return;
    }
    const blockTaskSet = new Set(blockTasks);
    let remaining = blockTasks.length;
    V.beforeEach(
    // Destructured so Vitest can parse the hook once the suite defines fixtures.
    ({
      onTestFinished,
      signal,
      task
    }) => {
      if (!blockTaskSet.has(task)) {
        return;
      }
      onTestFinished(() => {
        remaining--;
        if (remaining === 0) {
          return closeScope();
        }
      });
      return runPromise(Effect.asVoid(contextEffect), {
        signal
      });
    }, hookTimeout(options?.timeout));
    V.afterAll(() => closeScope(), hookTimeout(options?.timeout));
    return;
  }
  const suiteOptions = options?.concurrent === undefined ? {} : {
    concurrent: options.concurrent
  };
  return V.describe(args[0], suiteOptions, () => {
    V.beforeAll(() => runPromise(Effect.asVoid(contextEffect)), hookTimeout(options?.timeout));
    V.afterAll(() => closeScope(), hookTimeout(options?.timeout));
    return args[1](methods);
  });
};
/** @internal */
export const flakyTest = (self, timeout = Duration.seconds(30)) => pipe(self, Effect.scoped, Effect.sandbox, Effect.retry(pipe(Schedule.recurs(10), Schedule.while(_ => Effect.succeed(Duration.isLessThanOrEqualTo(Duration.fromInputUnsafe(_.elapsed), Duration.fromInputUnsafe(timeout)))))), Effect.orDie);
/** @internal */
export const makeMethods = it => makeItProxy(it, {
  effect: makeTester(flow(Effect.scoped, Effect.provide(TestEnv)), it),
  live: makeTester(Effect.scoped, it),
  flakyTest,
  layer: makeLayer(it),
  prop: makeProp(it)
});
/** @internal */
export const it = /*#__PURE__*/makeMethods(V.it);
/** @internal */
export const {
  /** @internal */
  effect,
  /** @internal */
  layer,
  /** @internal */
  live,
  /** @internal */
  prop
} = it;
/** @internal */
export const describeWrapped = (name, f) => V.describe(name, () => f(it));
//# sourceMappingURL=internal.js.map