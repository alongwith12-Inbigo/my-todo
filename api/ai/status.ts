import {
  dispatchVercelAiRoute,
  handleAiStatusRequest,
  type VercelLikeRequest,
  type VercelLikeResponse,
} from '../../server/aiRoutes.ts';

export default async function handler(
  req: VercelLikeRequest,
  res: VercelLikeResponse,
) {
  await dispatchVercelAiRoute(req, res, 'GET', () =>
    handleAiStatusRequest(req.headers.authorization, {}, req.headers.cookie),
  );
}
