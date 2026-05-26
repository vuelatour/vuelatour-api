import { Module } from '@nestjs/common';
import { ExpirationsController } from './expirations.controller';
import { ExpirationsService } from './expirations.service';

@Module({
  controllers: [ExpirationsController],
  providers: [ExpirationsService],
  exports: [ExpirationsService],
})
export class ExpirationsModule {}
