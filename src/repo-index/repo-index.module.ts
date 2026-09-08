import { Module } from '@nestjs/common';
import { RepoIndexCollectorService } from './repo-index-collector.service';
import { RepoIndexDispatcherService } from './repo-index-dispatcher.service';

@Module({
  providers: [RepoIndexCollectorService, RepoIndexDispatcherService],
  exports: [RepoIndexCollectorService, RepoIndexDispatcherService],
})
export class RepoIndexModule {}
