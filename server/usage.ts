// The usage fields that together make up the tokens actually present in the
// model's input context for a turn. `output_tokens` is the response the model
// produced, not part of its input, so it is intentionally excluded.
export function realTotalFromUsage(u: any): number {
  return (
    (u?.input_tokens ?? 0) +
    (u?.cache_creation_input_tokens ?? 0) +
    (u?.cache_read_input_tokens ?? 0)
  );
}
