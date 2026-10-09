import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DeviceModeStore } from '../realtime/deviceModeStore.js';
import { parseOrThrow } from '../validate.js';

const setRealtimeBodySchema = z.object({
  enabled: z.boolean(),
  durationS: z.coerce.number().int().positive().optional(),
  nodeIds: z.union([z.literal('all'), z.array(z.coerce.number().int().min(1).max(65535))]).optional(),
});

/**
 * Dashboard-token-guarded (lives under `/api/`, so the shared realm hook in
 * server.ts covers it -- never the device-token realm `GET /device/mode`
 * lives under). Both routes here and `GET /device/mode` (routes/device.ts)
 * read/write the SAME `DeviceModeStore` instance, passed in by the caller
 * (`startServer`/tests) so the operator's toggle and a node's next poll
 * always agree.
 */
export function registerRealtimeRoutes(app: FastifyInstance, deviceModeStore: DeviceModeStore): void {
  app.get('/api/realtime', async () => {
    return deviceModeStore.getPublicStatus();
  });

  app.post('/api/realtime', async (request, reply) => {
    const body = parseOrThrow(setRealtimeBodySchema, request.body);
    const result = deviceModeStore.setRealtime(body);
    if (result.status === 'duration-too-long') {
      return reply.code(400).send({
        error: 'invalid request',
        message: `durationS exceeds the configured maximum of ${result.maxDurationS}s`,
      });
    }
    return result.mode;
  });
}
