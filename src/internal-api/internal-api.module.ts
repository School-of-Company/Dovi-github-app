import { Module } from '@nestjs/common';
import { InternalSecretGuard } from './internal-secret.guard';
import { SandboxProbeTokenController } from './sandbox-probe-token.controller';

@Module({
  controllers: [SandboxProbeTokenController],
  providers: [InternalSecretGuard],
})
export class InternalApiModule {}
