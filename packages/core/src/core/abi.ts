export interface AbiField {
  readonly offset: number;
  readonly size: number;
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface AbiType {
  readonly kind: string;
  readonly size: number;
  readonly align: number;
  readonly fields?: Readonly<Record<string, AbiField>>;
  readonly values?: Readonly<Record<string, number>>;
  readonly bits?: Readonly<Record<string, AbiBitField>>;
  readonly [key: string]: unknown;
}

export interface AbiBitField {
  readonly lsb: number;
  readonly width: number;
  readonly arms?: Readonly<
    Record<string, { readonly bits?: Readonly<Record<string, AbiBitField>> }>
  >;
  readonly [key: string]: unknown;
}

export interface AbiManifest {
  readonly schema: number;
  readonly abi: {
    readonly target: string;
    readonly pointer_size: number;
    readonly usize_size: number;
    readonly endian: string;
  };
  readonly types: Readonly<Record<string, AbiType>>;
}

/** Thrown when a Ghostty WASM build has an incompatible or incomplete ABI manifest. */
export class UnsupportedGhosttyAbiError extends Error {
  /** Stable error name. */
  override readonly name = 'UnsupportedGhosttyAbiError';
}

/** Validated accessor for Ghostty's generated WASM ABI manifest. */
export class GhosttyAbi {
  /** Parsed ABI manifest. */
  readonly manifest: AbiManifest;

  /** Validates and wraps a Ghostty ABI manifest. */
  constructor(manifest: AbiManifest) {
    this.manifest = manifest;
    if (manifest.schema !== 1) {
      throw new UnsupportedGhosttyAbiError(`Unsupported Ghostty ABI schema ${manifest.schema}`);
    }
    if (
      manifest.abi.target !== 'wasm32' ||
      manifest.abi.pointer_size !== 4 ||
      manifest.abi.usize_size !== 4 ||
      manifest.abi.endian !== 'little'
    ) {
      throw new UnsupportedGhosttyAbiError('Expected the little-endian wasm32 Ghostty ABI');
    }
  }

  /** Returns a named ABI type descriptor. */
  type(name: string): AbiType {
    const descriptor = this.manifest.types[name];
    if (!descriptor) throw new UnsupportedGhosttyAbiError(`Missing Ghostty ABI type ${name}`);
    return descriptor;
  }

  /** Returns the byte size of a named ABI type. */
  size(name: string): number {
    return this.type(name).size;
  }

  /** Returns a named field descriptor from an ABI type. */
  field(typeName: string, fieldName: string): AbiField {
    const field = this.type(typeName).fields?.[fieldName];
    if (!field) {
      throw new UnsupportedGhosttyAbiError(`Missing Ghostty ABI field ${typeName}.${fieldName}`);
    }
    return field;
  }

  /** Returns a named numeric value from an ABI enum. */
  value(typeName: string, valueName: string): number {
    const value = this.type(typeName).values?.[valueName];
    if (value === undefined) {
      throw new UnsupportedGhosttyAbiError(`Missing Ghostty ABI value ${typeName}.${valueName}`);
    }
    return value;
  }

  /** Returns a bit-field descriptor, optionally nested below a tagged-union arm. */
  bit(typeName: string, fieldName: string, arm?: string, nestedField?: string): AbiBitField {
    let field = this.type(typeName).bits?.[fieldName];
    if (arm && nestedField) field = field?.arms?.[arm]?.bits?.[nestedField];
    if (!field) {
      const suffix = arm && nestedField ? `.${arm}.${nestedField}` : '';
      throw new UnsupportedGhosttyAbiError(
        `Missing Ghostty ABI bit field ${typeName}.${fieldName}${suffix}`
      );
    }
    return field;
  }
}
