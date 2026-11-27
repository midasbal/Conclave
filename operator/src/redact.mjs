/** RPC libraries put the endpoint, key and all, into their error messages. Nothing is logged without passing through this */
export function createRedactor(secrets) {
  const needles = [];
  for (const secret of secrets.filter(Boolean)) {
    needles.push(secret);
    try {
      const u = new URL(secret);
      for (const value of u.searchParams.values()) if (value.length >= 8) needles.push(value);
      if (u.pathname.length > 12) needles.push(u.pathname.slice(1));
    } catch { /* not a URL: the whole value is the needle */ }
  }
  return value => {
    let text = String(value?.message ?? value);
    for (const needle of needles) text = text.split(needle).join("[redacted]");
    return text.replace(/(https?:\/\/[^/\s"']+)[^\s"']*/g, "$1/[redacted]").slice(0, 400);
  };
}
