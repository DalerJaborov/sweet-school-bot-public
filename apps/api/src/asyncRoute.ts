import type { Router, RequestHandler } from "express";

/**
 * ЛОВИТ ОШИБКИ ИЗ ASYNC-ОБРАБОТЧИКОВ. Express 4 (мы на нём) не умеет сам
 * перехватывать отклонённый промис из `async (req, res) => {...}` — если внутри
 * бросает Prisma (например, `findMany({ take: NaN })` от `?take=abc` в строке
 * запроса), исключение улетает необработанным rejection'ом мимо `res.json` и
 * мимо общего error-middleware в index.ts. Запрос зависает навсегда, а Node по
 * умолчанию завершает процесс на unhandledRejection — то есть один плохой
 * параметр в URL мог положить всего бота.
 *
 * Патчим методы роутера один раз при создании: дальше КАЖДЫЙ `router.get(...)`
 * и подобные автоматически оборачивают обработчик в try/catch и зовут `next(err)`
 * при падении — никто не должен помнить об этом в каждом отдельном роуте.
 */
export function autoCatch(router: Router): Router {
  const methods = ["get", "post", "put", "patch", "delete"] as const;
  for (const method of methods) {
    const original = router[method].bind(router);
    router[method] = ((path: string, ...handlers: RequestHandler[]) => {
      const wrapped = handlers.map((h) =>
        h.length >= 4
          ? h // error-обработчики (req,res,next,err) не трогаем
          : ((req, res, next) => {
              try {
                const result: unknown = h(req, res, next);
                if (result != null && typeof (result as Promise<unknown>).catch === "function") {
                  (result as Promise<unknown>).catch(next);
                }
              } catch (err) {
                next(err);
              }
            }) as RequestHandler
      );
      return original(path, ...wrapped);
    }) as typeof router.get;
  }
  return router;
}
