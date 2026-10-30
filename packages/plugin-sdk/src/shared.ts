export type JsonValue = null | boolean | number | string | ReadonlyArray<JsonValue> | JsonObject;

export interface JsonObject {
  readonly [key: string]: JsonValue;
}
