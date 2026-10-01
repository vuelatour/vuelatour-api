import { Module } from '@nestjs/common';
import { StorageController } from './storage.controller';
import { StorageService } from './storage.service';

/** Firma genérica y acotada de archivos de Storage (1-oct-2026). */
@Module({
  controllers: [StorageController],
  providers: [StorageService],
})
export class StorageModule {}
