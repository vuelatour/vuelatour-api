import { Module } from '@nestjs/common';
import { PyservicesService } from './pyservices.service';

@Module({
  providers: [PyservicesService],
  exports: [PyservicesService],
})
export class PyservicesModule {}
