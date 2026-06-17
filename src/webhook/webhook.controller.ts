import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  UseGuards,
} from '@nestjs/common';
import { WebhookSignatureGuard } from './guards/webhook-signature.guard';
import { WebhookService } from './webhook.service';
import type { GithubWebhookPayload } from './dto/github-webhook-payload';

@Controller()
export class WebhookController {
  constructor(private readonly webhookService: WebhookService) {}

  @Post('webhook')
  @HttpCode(200)
  @UseGuards(WebhookSignatureGuard)
  handleWebhook(
    @Headers('x-github-event') event: string,
    @Body() payload: GithubWebhookPayload,
  ): void {
    this.webhookService.handle(event, payload);
  }
}
