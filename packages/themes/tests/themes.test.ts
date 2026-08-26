import { DEFAULT_THEME, resolveTerminalTheme } from '@gespenst/core';
import { describe, expect, it } from 'vitest';
import { gespenstDark, themeMetadata, themes } from '../src';

describe('@gespenst/themes', () => {
  it('ships a complete, attributed, valid catalog', () => {
    expect(Object.keys(themes)).toHaveLength(12);
    for (const [name, theme] of Object.entries(themes)) {
      const resolved = resolveTerminalTheme(theme);
      expect(resolved.palette, name).toHaveLength(256);
      expect(resolved.appearance, name).toBe(themeMetadata[name as keyof typeof themes].appearance);
      expect(themeMetadata[name as keyof typeof themes].revision.length).toBeGreaterThan(6);
      expect(Object.isFrozen(theme), name).toBe(true);
    }
  });

  it('keeps the core default and Gespenst dark catalog theme aligned', () => {
    expect(gespenstDark).toEqual(DEFAULT_THEME);
  });
});
