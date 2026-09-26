import { Module } from '@nestjs/common';
import { DicoshotModule } from 'dicoshot-nest';
import { SandboxProbeResponderService } from './sandbox-probe-responder.service';
import { SandboxProbeResultConsumerService } from './sandbox-probe-result-consumer.service';

@Module({
  imports: [
    DicoshotModule.register({
      webhookUrl: process.env.DISCORD_WEBHOOK_URL ?? '',
      applicationName: 'dovi-github-app',
    }),
  ],
  providers: [SandboxProbeResponderService, SandboxProbeResultConsumerService],
})
export class SandboxProbeResultModule {}
