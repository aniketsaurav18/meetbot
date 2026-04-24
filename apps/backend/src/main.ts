import 'dotenv/config';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors();
  app.enableShutdownHooks();
  await app.listen(port, host);
  console.log(`[backend] listening on http://${host}:${port}`);
}

bootstrap().catch((error) => {
  console.error('[backend] failed to start:', error);
  process.exit(1);
});
