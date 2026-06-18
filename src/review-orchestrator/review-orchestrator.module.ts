import { Module } from '@nestjs/common';
import { DicoshotModule } from 'dicoshot-nest';
import { REVIEW_ORCHESTRATOR } from './review-orchestrator.interface';
import { ReviewOrchestratorService } from './review-orchestrator.service';

@Module({
  imports: [
    DicoshotModule.register({
      webhookUrl: process.env.DISCORD_WEBHOOK_URL ?? '',
      applicationName: 'dovi-github-app',
    }),
  ],
  providers: [
    {
      provide: REVIEW_ORCHESTRATOR,
      useClass: ReviewOrchestratorService,
    },
  ],
  exports: [REVIEW_ORCHESTRATOR],
})
export class ReviewOrchestratorModule {}
