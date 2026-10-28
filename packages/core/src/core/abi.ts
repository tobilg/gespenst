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

/** A bit field prepared for decoding many values, with its mask computed once. */
export interface PackedBitField {
  readonly lsb: number;
  readonly width: number;
  readonly mask: number;
}

/** Prepares an ABI bit field for {@link packedBits}. */
export function packedBitField(field: AbiBitField): PackedBitField {
  return { lsb: field.lsb, width: field.width, mask: 2 ** field.width - 1 };
}

/** Reads one bit field from a 64-bit ABI value split into its low and high 32-bit words. */
export function packedBits(low: number, high: number, field: PackedBitField): number {
  const { lsb, mask } = field;
  if (lsb >= 32) return (high >>> (lsb - 32)) & mask;
  if (lsb + field.width <= 32) return (low >>> lsb) & mask;
  return ((low >>> lsb) | (high << (32 - lsb))) & mask;
}

/** Bit fields of a raw `GhosttyCell`, prepared for decoding many cells. */
export interface CellBitFields {
  readonly contentTag: PackedBitField;
  readonly content: PackedBitField;
  readonly codepoint: PackedBitField;
  readonly styleId: PackedBitField;
  readonly wide: PackedBitField;
  readonly hyperlink: PackedBitField;
  readonly semanticContent: PackedBitField;
  readonly tagCodepoint: number;
  readonly tagGrapheme: number;
}

/** Returns the `GhosttyCell` bit fields used to decode raw cells. */
export function cellBitFields(abi: GhosttyAbi): CellBitFields {
  const bit = (name: string) => packedBitField(abi.bit('GhosttyCell', name));
  return {
    contentTag: bit('content_tag'),
    content: bit('content'),
    codepoint: packedBitField(abi.bit('GhosttyCell', 'content', 'CODEPOINT', 'codepoint')),
    styleId: bit('style_id'),
    wide: bit('wide'),
    hyperlink: bit('hyperlink'),
    semanticContent: bit('semantic_content'),
    tagCodepoint: abi.value('GhosttyCellContentTag', 'CODEPOINT'),
    tagGrapheme: abi.value('GhosttyCellContentTag', 'CODEPOINT_GRAPHEME'),
  };
}

/** Reads the codepoint held in a raw cell's content field, whatever its content tag. */
export function cellCodepoint(low: number, high: number, bits: CellBitFields): number {
  return (packedBits(low, high, bits.content) >>> bits.codepoint.lsb) & bits.codepoint.mask;
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
