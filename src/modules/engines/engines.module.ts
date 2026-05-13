import { Module } from '@nestjs/common';
import { EnginesController } from './engines.controller';
import { EnginesService } from './engines.service';

@Module({
  controllers: [EnginesController],
  providers: [EnginesService],
  exports: [EnginesService],
})
export class EnginesModule {}
