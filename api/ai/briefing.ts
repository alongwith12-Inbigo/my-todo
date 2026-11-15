import {
  dispatchVercelAiRoute,
  handleAiBriefingRequest,
  type VercelLikeRequest,
  type VercelLikeResponse,
} from '../../server/aiRoutes.ts';

export default async function handler(
  req: VercelLikeRequest,
  res: VercelLikeResponse,
) {
  await dispatchVercelAiRoute(req, res, 'POST', (signal) =>
    handleAiBriefingRequest({
      authorizationHeader: req.headers.authorization,
      cookieHeader: req.headers.cookie,
      body: req.body,
      signal,
    }),
  );
}
