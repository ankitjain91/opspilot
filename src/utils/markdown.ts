export function fixMarkdownHeaders(text: string): string {
    // Fix markdown headers that don't have a space after the hash
    return text.replace(/^(#+)([^#\s])/gm, '$1 $2');
}
