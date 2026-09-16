import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import express from 'express';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: false });

  const captureRawBody = (
    req: express.Request & { rawBody?: Buffer },
    _res: express.Response,
    buf: Buffer,
  ) => {
    req.rawBody = buf;
  };

  // GitHub 웹훅 페이로드는 최대 25MB까지 온다 (express 기본 limit은 100kb).
  app.use(express.json({ verify: captureRawBody, limit: '25mb' }));
  app.use(
    express.urlencoded({
      extended: false,
      verify: captureRawBody,
      limit: '25mb',
    }),
  );

  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
