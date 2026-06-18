import { Module } from '@nestjs/common';
import { PrDataCollectorService } from './pr-data-collector.service';

@Module({
  providers: [PrDataCollectorService],
  exports: [PrDataCollectorService],
})
export class PrDataCollectorModule {}
