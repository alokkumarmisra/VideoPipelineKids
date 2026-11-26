// LLM Response Cache for Sanskriti AI Studio Director Module
// Caches LLM chat responses to avoid redundant model calls
// Keys are based on prompt hash + model + temperature + other parameters

// Cache configuration
const CACHE_TTL = 24 * 60 * 60 * 1000 // 24 hours
const MAX_CACHE_SIZE = 500 // Maximum number of cached entries

// Simple in-memory cache
// In production, this could be backed by Redis or a database
let cache = new Map()

// Hash function for prompt caching
function hashPrompt(prompt, options = {}) {
  const crypto = require ? require('crypto') : null
  if (crypto) {
    const input = `${prompt}|${options.model}|${options.temperature}|${options.maxTokens}|${options.topP || ''}`
    return crypto.createHash('sha256').update(input).digest('hex')
  }
  // Fallback: simple hash without crypto
  let hash = 0
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0
  }
  return hash.toString(36)
}

// Get cached response if available
export function getCachedResponse(key) {
  const entry = cache.get(key)
  if (!entry) return null

  const { response, timestamp } = entry
  if (Date.now() - timestamp > CACHE_TTL) {
    // Expired
    cache.delete(key)
    return null
  }

  return response
}

// Store response in cache
export function setCachedResponse(key, response) {
  // Evict oldest entries if over capacity
  if (cache.size >= MAX_CACHE_SIZE) {
    const firstKey = cache.keys().next().value
    cache.delete(firstKey)
  }

  cache.set(key, {
    response,
    timestamp: Date.now()
  })
}

// Clear cache for a specific key
export function clearCachedResponse(key) {
  cache.delete(key)
}

// Clear entire cache
export function clearAllCache() {
  cache.clear()
}

// Get cache statistics
export function getCacheStats() {
  return {
    size: cache.size,
    maxSize: MAX_CACHE_SIZE,
    ttlMs: CACHE_TTL,
    entries: Array.from(cache.entries()).map(([key, { response }]) => ({
      keyPrefix: key.substring(0, 16) + '...',
      responseType: typeof response,
      hasResponse: !!response
    }))
  }
}

// Wrap llmChatJson to add caching
export function wrapLlmChatWithCache(llmChatJsonOriginal) {
  return async function cachedLlmChatJson(...args) {
    // Extract options from args to build cache key
    // The last argument typically contains options, or they're embedded in the function signature
    const lastArg = args[args.length - 1] || {}

    // Build cache key from prompt + model + temperature
    let promptKey = ''
    if (args[0] && args[0].messages) {
      // Chat format
      const lastMessage = args[0].messages[args[0].messages.length - 1]
      promptKey = lastMessage?.content || ''
    } else if (args[0] && typeof args[0] === 'string') {
      promptKey = args[0]
    }

    const model = lastArg.model || ''
    const temperature = lastArg.temperature || 0.7
    const maxTokens = lastArg.maxTokens || 1000

    const cacheKey = hashPrompt(promptKey, { model, temperature, maxTokens })

    // Check cache first
    const cached = getCachedResponse(cacheKey)
    if (cached) {
      // console.log('[LLM Cache] Cache hit for key:', cacheKey.substring(0, 16) + '...')
      return cached
    }

    // Call original function
    const result = await llmChatJsonOriginal(...args)

    // Cache the response
    setCachedResponse(cacheKey, result)

    return result
  }
}

// Wrap llmChatJsonLive to add caching
export function wrapLlmChatJsonLiveWithCache(llmChatJsonLiveOriginal) {
  return async function cachedLlmChatJsonLive(...args) {
    const lastArg = args[args.length - 1] || {}

    let promptKey = ''
    if (args[0] && args[0].messages) {
      const lastMessage = args[0].messages[args[0].messages.length - 1]
      promptKey = lastMessage?.content || ''
    } else if (args[0] && typeof args[0] === 'string') {
      promptKey = args[0]
    }

    const model = lastArg.model || ''
    const temperature = lastArg.temperature || 0.7
    const maxTokens = lastArg.maxTokens || 1000

    const cacheKey = hashPrompt(promptKey, { model, temperature, maxTokens })

    const cached = getCachedResponse(cacheKey)
    if (cached) {
      // console.log('[LLM Cache] Cache hit for live key:', cacheKey.substring(0, 16) + '...')
      return cached
    }

    const result = await llmChatJsonLiveOriginal(...args)
    setCachedResponse(cacheKey, result)

    return result
  }
}

// Export hash function for manual use
export { hashPrompt }

export default {
  getCachedResponse,
  setCachedResponse,
  clearCachedResponse,
  clearAllCache,
  getCacheStats,
  wrapLlmChatWithCache,
  wrapLlmChatJsonLiveWithCache,
  hashPrompt
}