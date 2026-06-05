import { Module } from '@nestjs/common';
import { ExpirationsClient } from './expirations.client';
import { ExpirationsController } from './expirations.controller';
import { ExpirationsService } from './expirations.service';

@Module({
  controllers: [ExpirationsController],
  providers: [ExpirationsService, ExpirationsClient],
  exports: [ExpirationsService],
})
export class ExpirationsModule {}
