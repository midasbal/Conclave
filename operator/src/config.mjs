// The operator's settings, from the environment. Loading never throws: a setting that is missing or wrong is listed in `problems`, the service still
// starts (so the platform's deploy check passes), and it refuses to send anything until the list is empty.
export const LAMPORTS_PER_SOL = 1_000_000_000;
/** the fee of a one-signature transfer; counted against the daily cap with each top-up */
export const FEE_LAMPORTS = 5_000;
export const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
export const PROGRAM_ID = "HZ3b6zexePfH5cXT5qaKKHfA8B29xwBGGYgu84WgMdne";
const MAX_TOPUP_SOL = 0.05;

export function loadConfig(env = process.env) {
  const problems = [];
  const text = name => (env[name] ?? "").trim();

  const number = (name, fallback, { min, max, integer = false }) => {
    const raw = text(name);
    if (raw === "") return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
      problems.push(`${name} must be ${integer ? "a whole number" : "a number"} from ${min} to ${max}`);
      return fallback;
    }
    return value;
  };
  const lamports = (name, fallback, bounds) => Math.round(number(name, fallback, bounds) * LAMPORTS_PER_SOL);

  // the endpoint carries its key in the URL. It is never logged or returned: only the host is
  let rpcUrl = null, rpcHost = null;
  const rawUrl = text("OPERATOR_RPC_URL");
  if (rawUrl === "") problems.push("OPERATOR_RPC_URL is not set");
  else {
    try {
      const u = new URL(rawUrl);
      const local = u.hostname === "127.0.0.1" || u.hostname === "localhost";
      if (u.protocol !== "https:" && !local) problems.push("OPERATOR_RPC_URL must use https");
      else if (/(^|\.)helius-rpc\.com$/i.test(u.hostname) && !u.searchParams.get("api-key")) problems.push("OPERATOR_RPC_URL is a Helius address without an api-key parameter (expected https://devnet.helius-rpc.com/?api-key=...)");
      else { rpcUrl = rawUrl; rpcHost = u.host; }
    } catch { problems.push("OPERATOR_RPC_URL is not a URL"); }
  }

  // the funded set and the day's total must outlive a restart, or the daily cap resets with it
  const onRailway = text("RAILWAY_ENVIRONMENT") !== "" || text("RAILWAY_PROJECT_ID") !== "";
  const stateDir = text("OPERATOR_STATE_DIR") || text("RAILWAY_VOLUME_MOUNT_PATH");
  if (!stateDir) problems.push("no state directory: attach a volume (RAILWAY_VOLUME_MOUNT_PATH) or set OPERATOR_STATE_DIR");
  if (onRailway && !text("RAILWAY_VOLUME_MOUNT_PATH")) problems.push("running on Railway without a volume: the daily cap would reset on every deploy");

  const topupLamports = lamports("OPERATOR_TOPUP_SOL", 0.01, { min: 0.001, max: MAX_TOPUP_SOL });
  const thresholdLamports = text("OPERATOR_THRESHOLD_SOL") === "" ? topupLamports : lamports("OPERATOR_THRESHOLD_SOL", 0.01, { min: 0.0001, max: 1 });

  const sharedSecret = text("OPERATOR_SHARED_SECRET");
  if (sharedSecret !== "" && sharedSecret.length < 24) problems.push("OPERATOR_SHARED_SECRET must be at least 24 characters, or unset");

  return {
    problems,
    rpcUrl,
    rpcHost,
    stateDir: stateDir || null,
    topupLamports,
    thresholdLamports,
    dailyCapLamports: lamports("OPERATOR_DAILY_CAP_SOL", 0.3, { min: 0, max: 100 }),
    sendsPerIpPerHour: number("OPERATOR_IP_PER_HOUR", 5, { min: 1, max: 10_000, integer: true }),
    requestsPerIpPerHour: number("OPERATOR_REQUESTS_PER_IP_HOUR", 60, { min: 1, max: 100_000, integer: true }),
    requestsPerHour: number("OPERATOR_REQUESTS_PER_HOUR", 600, { min: 1, max: 1_000_000, integer: true }),
    confirmTimeoutMs: number("OPERATOR_CONFIRM_TIMEOUT_SECONDS", 40, { min: 5, max: 90 }) * 1000,
    sharedSecret: sharedSecret || null,
    programId: text("OPERATOR_PROGRAM_ID") || PROGRAM_ID,
    port: number("PORT", 8788, { min: 1, max: 65535, integer: true }),
    host: text("HOST") || "0.0.0.0",
  };
}
