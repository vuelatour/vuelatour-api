import { Module } from '@nestjs/common';
import { PilotsModule } from '../pilots/pilots.module';
import { UsersModule } from '../users/users.module';
import { MeCapturasService } from './me-capturas.service';
import { MeController } from './me.controller';

@Module({
  imports: [UsersModule, PilotsModule],
  controllers: [MeController],
  providers: [MeCapturasService],
})
export class MeModule {}
