/**
 * The contact form's request to `/api/contact`.
 *
 * Without a file it is the same JSON as ever. With one (G-V2-01) it is
 * multipart: the fields as JSON in `payload`, the file in `attachment`. The
 * content type is then left to the browser, which must add the boundary.
 */
export function contactRequestInit(
  fields: Record<string, string>,
  file: File | null,
  headers: Record<string, string>
): RequestInit & { headers: Record<string, string> } {
  if (!file) {
    return {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(fields),
    };
  }
  const body = new FormData();
  body.set('payload', JSON.stringify(fields));
  body.set('attachment', file, file.name);
  return { method: 'POST', headers: { ...headers }, body };
}
