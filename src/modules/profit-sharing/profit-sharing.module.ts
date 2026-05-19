import { Module } from '@nestjs/common';
import { PyservicesModule } from '../pyservices/pyservices.module';
import { ProfitSharingController } from './profit-sharing.controller';
import { ProfitSharingService } from './profit-sharing.service';

@Module({
  imports: [PyservicesModule],
  controllers: [ProfitSharingController],
  providers: [ProfitSharingService],
  exports: [ProfitSharingService],
})
export class ProfitSharingModule {}
