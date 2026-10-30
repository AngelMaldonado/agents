// Release policy, deliberately not overridable by legacy environment variables.
// Keep deferred code/migrations, but do not expose WhatsApp in the baseline product.
export const FEATURES = { whatsapp: false } as const;
