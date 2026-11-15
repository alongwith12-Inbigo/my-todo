import {
  dispatchVercelAiRoute,
  handleDeleteByokKeyRequest,
  handleSaveByokKeyRequest,
  type VercelLikeRequest,
  type VercelLikeResponse,
} from '../../server/aiRoutes.ts';

function isHttpsRequest(req: VercelLikeRequest): boolean {
  const proto = req.headers['x-forwarded-proto'];
  const val = Array.isArray(proto) ? proto[0] : proto;
  return typeof val === 'string' && val.toLowerCase().includes('https');
}

export default async function handler(
  req: VercelLikeRequest,
  res: VercelLikeResponse,
) {
  await dispatchVercelAiRoute(req, res, ['POST', 'DELETE'], (signal) => {
    if (req.method === 'DELETE') {
      return handleDeleteByokKeyRequest({
        authorizationHeader: req.headers.authorization,
        isSecure: isHttpsRequest(req),
      });
    }
    return handleSaveByokKeyRequest({
      authorizationHeader: req.headers.authorization,
      body: req.body,
      isSecure: isHttpsRequest(req),
      signal,
    });
  });
}
