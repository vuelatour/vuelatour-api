import { Module } from '@nestjs/common';
import { BankMovementsController } from './bank-movements.controller';
import { BankMovementsService } from './bank-movements.service';
import { TreasuryController } from './treasury.controller';
import { TreasuryService } from './treasury.service';

@Module({
  controllers: [BankMovementsController, TreasuryController],
  providers: [BankMovementsService, TreasuryService],
  exports: [BankMovementsService, TreasuryService],
})
export class TreasuryModule {}
