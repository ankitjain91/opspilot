/**
 * Centralized keyboard shortcuts hook
 * Provides platform-aware keyboard shortcuts (Cmd on Mac, Ctrl on Windows/Linux)
 */

import { useEffect, useCallback, useRef } from 'react';

// Detect platform
export const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);

// Get the modifier key name for display
export const modKey = isMac ? '⌘' : 'Ctrl';
export const altKey = isMac ? '⌥' : 'Alt';
export const shiftKey = '⇧';

export interface KeyboardShortcut {
    key: string;
    modifiers?: ('cmd' | 'ctrl' | 'alt' | 'shift')[];
    description: string;
    category: string;
    action: () => void;
    // If true, requires exact modifier match (no extra modifiers)
    exact?: boolean;
    // If true, works even when input is focused
    global?: boolean;
}

// Check if event matches shortcut
function matchesShortcut(e: KeyboardEvent, shortcut: KeyboardShortcut): boolean {
    const keyMatch = e.key.toLowerCase() === shortcut.key.toLowerCase();
    if (!keyMatch) return false;

    const mods = shortcut.modifiers || [];
    const needsCmd = mods.includes('cmd') || mods.includes('ctrl');
    const needsAlt = mods.includes('alt');
    const needsShift = mods.includes('shift');

    const hasCmd = e.metaKey || e.ctrlKey;
    const hasAlt = e.altKey;
    const hasShift = e.shiftKey;

    if (shortcut.exact) {
        return keyMatch &&
            hasCmd === needsCmd &&
            hasAlt === needsAlt &&
            hasShift === needsShift;
    }

    // Non-exact: just check required modifiers are present
    return keyMatch &&
        (!needsCmd || hasCmd) &&
        (!needsAlt || hasAlt) &&
        (!needsShift || hasShift);
}

// Check if element is an input
function isInputElement(element: Element | null): boolean {
    if (!element) return false;
    const tagName = element.tagName.toLowerCase();
    return tagName === 'input' ||
        tagName === 'textarea' ||
        tagName === 'select' ||
        (element as HTMLElement).isContentEditable;
}

export function useKeyboardShortcuts(shortcuts: KeyboardShortcut[]) {
    const shortcutsRef = useRef(shortcuts);
    shortcutsRef.current = shortcuts;

    const handleKeyDown = useCallback((e: KeyboardEvent) => {
        const isInput = isInputElement(document.activeElement);

        for (const shortcut of shortcutsRef.current) {
            // Skip non-global shortcuts when in input
            if (isInput && !shortcut.global) continue;

            if (matchesShortcut(e, shortcut)) {
                e.preventDefault();
                e.stopPropagation();
                shortcut.action();
                return;
            }
        }
    }, []);

    useEffect(() => {
        window.addEventListener('keydown', handleKeyDown, true);
        return () => window.removeEventListener('keydown', handleKeyDown, true);
    }, [handleKeyDown]);
}

// Format shortcut for display
export function formatShortcut(shortcut: KeyboardShortcut): string {
    const parts: string[] = [];
    const mods = shortcut.modifiers || [];

    if (mods.includes('cmd') || mods.includes('ctrl')) {
        parts.push(modKey);
    }
    if (mods.includes('alt')) {
        parts.push(altKey);
    }
    if (mods.includes('shift')) {
        parts.push(shiftKey);
    }

    // Format the key
    let keyDisplay = shortcut.key.toUpperCase();
    if (shortcut.key === 'Escape') keyDisplay = 'Esc';
    if (shortcut.key === 'ArrowUp') keyDisplay = '↑';
    if (shortcut.key === 'ArrowDown') keyDisplay = '↓';
    if (shortcut.key === 'ArrowLeft') keyDisplay = '←';
    if (shortcut.key === 'ArrowRight') keyDisplay = '→';
    if (shortcut.key === 'Enter') keyDisplay = '↵';
    if (shortcut.key === ' ') keyDisplay = 'Space';
    if (shortcut.key === '`') keyDisplay = '`';

    parts.push(keyDisplay);

    return parts.join(isMac ? '' : '+');
}

// Get all shortcuts grouped by category
export function groupShortcutsByCategory(shortcuts: KeyboardShortcut[]): Record<string, KeyboardShortcut[]> {
    return shortcuts.reduce((acc, shortcut) => {
        if (!acc[shortcut.category]) {
            acc[shortcut.category] = [];
        }
        acc[shortcut.category].push(shortcut);
        return acc;
    }, {} as Record<string, KeyboardShortcut[]>);
}
