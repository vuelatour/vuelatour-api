import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { MeCapturasService } from './me-capturas.service';
import { MeController } from './me.controller';

@Module({
  imports: [UsersModule],
  controllers: [MeController],
  providers: [MeCapturasService],
})
export class MeModule {}
