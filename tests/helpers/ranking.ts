/**
 * Thin re-export layer: the test suite exercises the fusion and recency helpers
 * through this module so `hybrid.ts` keeps a single, documented public surface.
 */
export { fuse as rrfFuse, recencyBonus } from "@/lib/retrieval/hybrid";
