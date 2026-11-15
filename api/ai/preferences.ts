import {
  dispatchVercelAiRoute,
  handleUpdateAiPreferencesRequest,
  type VercelLikeRequest,
  type VercelLikeResponse,
} from '../../server/aiRoutes.ts';

export default async function handler(
  req: VercelLikeRequest,
  res: VercelLikeResponse,
) {
  await dispatchVercelAiRoute(req, res, 'POST', () =>
    handleUpdateAiPreferencesRequest({
      authorizationHeader: req.headers.authorization,
      body: req.body,
    }),
  );
}
