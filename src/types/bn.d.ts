// Ambient declaration for bn.js — a transitive dependency of the SAP SDK.
// No @types/bn.js package is available, so we declare the module manually.
declare module 'bn.js' {
  class BN {
    constructor(value: number | string | BN, base?: number | 'hex', endian?: string);
    toNumber(): number;
    toString(base?: number | 'hex'): string;
    add(b: BN): BN;
    sub(b: BN): BN;
    mul(b: BN): BN;
    div(b: BN): BN;
    mod(b: BN): BN;
    lt(b: BN): boolean;
    lte(b: BN): boolean;
    gt(b: BN): boolean;
    gte(b: BN): boolean;
    eq(b: BN): boolean;
    isZero(): boolean;
    isNeg(): boolean;
    toArray(endian?: string, length?: number): number[];
    toBuffer(endian?: string, length?: number): Buffer;
    toArrayLike(type: typeof Buffer, endian?: string, length?: number): Buffer;
    static isBN(b: unknown): b is BN;
  }
  export = BN;
}
