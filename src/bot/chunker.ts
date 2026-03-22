export function chunkText(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    let splitAt = maxLength;

    // Try to split at paragraph boundary
    const paragraphIdx = remaining.lastIndexOf("\n\n", maxLength);
    if (paragraphIdx > maxLength * 0.3) {
      splitAt = paragraphIdx + 2;
    } else {
      // Try to split at line boundary
      const lineIdx = remaining.lastIndexOf("\n", maxLength);
      if (lineIdx > maxLength * 0.3) {
        splitAt = lineIdx + 1;
      } else {
        // Try to split at sentence boundary
        const sentenceMatch = remaining.slice(0, maxLength).match(/.*[.!?。！？]\s*/s);
        if (sentenceMatch && sentenceMatch[0].length > maxLength * 0.3) {
          splitAt = sentenceMatch[0].length;
        }
      }
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }

  // Add part markers if multiple chunks
  if (chunks.length > 1) {
    return chunks.map((chunk, i) => `[${i + 1}/${chunks.length}]\n${chunk}`);
  }

  return chunks;
}
