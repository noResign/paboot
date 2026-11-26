import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Express 4 does not observe rejected promises from async handlers: a throw
 * inside one leaves the request hanging and surfaces as an `unhandledRejection`
 * (which Node treats as fatal by default). Forward rejections to the error
 * middleware so callers get a 500 instead of a dead connection.
 */
export function asyncRoute(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
): RequestHandler {
  return (req, res, next) => {
    void fn(req, res, next).catch(next);
  };
}
