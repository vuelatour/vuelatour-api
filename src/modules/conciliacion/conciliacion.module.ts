import { Module } from '@nestjs/common';
import { PyservicesModule } from '../pyservices/pyservices.module';
import { ConciliacionController } from './conciliacion.controller';
import { ConciliacionService } from './conciliacion.service';

@Module({
  imports: [PyservicesModule],
  controllers: [ConciliacionController],
  providers: [ConciliacionService],
  exports: [ConciliacionService],
})
export class ConciliacionModule {}
