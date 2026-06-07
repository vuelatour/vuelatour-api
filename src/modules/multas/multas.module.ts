import { Module } from '@nestjs/common';
import { MultasController } from './multas.controller';
import { MultasService } from './multas.service';

@Module({
  controllers: [MultasController],
  providers: [MultasService],
  exports: [MultasService],
})
export class MultasModule {}
