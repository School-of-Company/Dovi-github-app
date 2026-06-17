import { Module } from '@nestjs/common';
import { PrDataCollectorService } from './pr-data-collector.service';
import { INSTALLATION_TOKEN_MANAGER } from '../installation-token/installation-token-manager.interface';

@Module({
  providers: [
    PrDataCollectorService,
    {
      provide: INSTALLATION_TOKEN_MANAGER,
      useFactory: () => {
        throw new Error(
          'InstallationTokenManager is not implemented. Provide a concrete class.',
        );
      },
    },
  ],
  exports: [PrDataCollectorService],
})
export class PrDataCollectorModule {}
