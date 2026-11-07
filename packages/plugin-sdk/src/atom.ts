import type * as EffectAtom from "effect/reactivity/Atom";

// T3's own `Atom` functions, so a plugin's atoms work with the shared `@effect/atom-react` hooks
// without bundling effect. Import as `import * as Atom from "@t3tools/plugin-sdk/atom"` and build
// with `@t3tools/plugin-sdk/vite`. Make atoms from values and functions: an Effect or a Stream
// would come from the plugin's own copy of effect, not T3's.
export type { Atom, AtomContext, Writable, WriteContext } from "effect/reactivity/Atom";

export declare const family: typeof EffectAtom.family;
export declare const keepAlive: typeof EffectAtom.keepAlive;
export declare const make: typeof EffectAtom.make;
export declare const map: typeof EffectAtom.map;
export declare const readable: typeof EffectAtom.readable;
export declare const setIdleTTL: typeof EffectAtom.setIdleTTL;
export declare const transform: typeof EffectAtom.transform;
export declare const withLabel: typeof EffectAtom.withLabel;
export declare const writable: typeof EffectAtom.writable;
