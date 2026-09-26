import { Module } from '@nestjs/common';
import { SandboxProbeDispatcherService } from './sandbox-probe-dispatcher.service';

@Module({
  providers: [SandboxProbeDispatcherService],
  exports: [SandboxProbeDispatcherService],
})
export class SandboxProbeModule {}
