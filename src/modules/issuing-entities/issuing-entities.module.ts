import { Module } from '@nestjs/common';
import { IssuingEntitiesController } from './issuing-entities.controller';
import { IssuingEntitiesService } from './issuing-entities.service';

@Module({
  controllers: [IssuingEntitiesController],
  providers: [IssuingEntitiesService],
  exports: [IssuingEntitiesService],
})
export class IssuingEntitiesModule {}
