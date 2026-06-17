import { Module } from '@nestjs/common';
import { PrDataCollectorService } from './pr-data-collector.service';
import { INSTALLATION_TOKEN_MANAGER } from '../installation-token/installation-token-manager.interface';

@Module({
  providers: [
    PrDataCollectorService,
    {
      provide: INSTALLATION_TOKEN_MANAGER,
      useValue: null,
    },
  ],
  exports: [PrDataCollectorService],
})
export class PrDataCollectorModule {}
