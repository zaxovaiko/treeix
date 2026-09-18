/** Placeholder host for attachment images; nothing is ever requested from it */
export const IMAGE_HOST = 'https://treeix.invalid'

export type ImageResult = { dataUrl: string } | { error: string }

export type CredentialsStatus = { email: string | null; hasToken: boolean }

export type Credentials = { email: string; token: string }

export type Json = Record<string, unknown>
export const isJson = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)
export const object = (value: unknown): Json => (isJson(value) ? value : {})
export const text = (value: unknown): string => (typeof value === 'string' ? value : '')
export const orNull = (value: string): string | null => value || null
