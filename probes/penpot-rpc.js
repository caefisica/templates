// args: cmd, params (JSON). Calls Penpot's RPC from the page session.
const response = await fetch(`/api/rpc/command/${args.cmd}`, {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json" },
  body: args.params ?? "{}",
  credentials: "include",
});
const text = await response.text();
try {
  return { status: response.status, body: JSON.parse(text) };
} catch {
  return { status: response.status, body: text.slice(0, 500) };
}
