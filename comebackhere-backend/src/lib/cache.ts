import Redis from "ioredis"

let _redis: Redis | null = null

function getRedis(): Redis | null {
  if (_redis) return _redis
  const redisUrl = process.env.REDIS_URL
  if (!redisUrl) return null
  _redis = new Redis(redisUrl, { lazyConnect: true })
  _redis.on("error", () => {})
  return _redis
}

export function resetRedis(): void {
  _redis = null
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  const redis = getRedis()
  if (!redis) return null
  try {
    const raw = await redis.get(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

export async function cacheSet(key: string, value: unknown, ttlSec = 30): Promise<void> {
  const redis = getRedis()
  if (!redis) return
  try {
    await redis.setex(key, ttlSec, JSON.stringify(value))
  } catch {
    // silently fail – cache is optional
  }
}
